import { describe, it, expect, beforeEach } from 'vitest';
import {
  canVouchOnChain,
  decideTokenTrust,
  marksAreGatewayServed,
  membershipOf,
  openTokenListLookup,
  probeTokenTrust,
  tokenListAddressSet,
  type TokenListLookup,
} from './tokenTrust';
import { clearTokenListCacheForTests } from './tokenSearch';

const GATEWAY = 'https://network.satorigo.app';
const BASE = { trustWalletChain: 'base', tokenListSlug: 'base' };
/** Circle's USDC on Base, the wallet's default token there. */
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** A contract that answers symbol() = "USDC" but is nobody's USDC. */
const COUNTERFEIT = '0x1111111111111111111111111111111111111111';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function pngResponse(): Response {
  return new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } });
}

function listResponse(addresses: readonly string[]): Response {
  const tokens = addresses.map((address) => ({ address, name: 'Token', symbol: 'TKN', decimals: 18 }));
  return new Response(JSON.stringify({ tokens }), { status: 200 });
}

/** A fetch that answers marks and token lists from fixed sets. */
function fakeFetch(opts: { marks?: readonly string[]; list?: readonly string[] | 'down' }): typeof fetch {
  const marks = new Set((opts.marks ?? []).map((a) => a.toLowerCase()));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/tokenlist/') || url.includes('all.json')) {
      if (opts.list === 'down') throw new Error('offline');
      return listResponse(opts.list ?? []);
    }
    // The mark URL is `.../marks/<chain>/<address>` through the gateway and
    // `.../assets/<address>/logo.png` from the public registry: pull the
    // contract out of either shape.
    const address = /0x[0-9a-fA-F]{40}/.exec(url)?.[0] ?? '';
    return marks.has(address.toLowerCase()) ? pngResponse() : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearTokenListCacheForTests();
});

describe('decideTokenTrust: no gateway keeps the old one-signal rule', () => {
  const noGateway = { requireBothSignals: false } as const;

  it('a mark from the public registry is enough', () => {
    expect(decideTokenTrust({ ...noGateway, mark: 'found', membership: 'unlisted' })).toBe(true);
    expect(decideTokenTrust({ ...noGateway, mark: 'found', membership: 'no-list' })).toBe(true);
    expect(decideTokenTrust({ ...noGateway, mark: 'found', membership: 'unknown' })).toBe(true);
  });

  it('no mark is untrusted', () => {
    expect(decideTokenTrust({ ...noGateway, mark: 'missing', membership: 'listed' })).toBe(false);
  });

  it('a transport failure is still no verdict', () => {
    expect(decideTokenTrust({ ...noGateway, mark: 'error', membership: 'listed' })).toBeUndefined();
  });
});

describe('decideTokenTrust: with a gateway both signals are required', () => {
  const gateway = { requireBothSignals: true } as const;

  it('vouches only when the contract is in the token list AND has a mark', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'found', membership: 'listed' })).toBe(true);
  });

  it('THE FIX: a mark alone no longer suppresses the warning', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'found', membership: 'unlisted' })).toBe(false);
  });

  it('a chain with no token list at all can never vouch', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'found', membership: 'no-list' })).toBe(false);
  });

  it('list membership alone is not enough either', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'missing', membership: 'listed' })).toBe(false);
  });

  it('an unreadable token list produces NO verdict, not a warning on real USDC', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'found', membership: 'unknown' })).toBeUndefined();
  });

  it('a mark probe that failed at the transport produces no verdict', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'error', membership: 'listed' })).toBeUndefined();
    expect(decideTokenTrust({ ...gateway, mark: 'error', membership: 'unknown' })).toBeUndefined();
  });

  it('settles "no mark" without needing the list to be readable', () => {
    expect(decideTokenTrust({ ...gateway, mark: 'missing', membership: 'unknown' })).toBe(false);
  });
});

describe('marksAreGatewayServed', () => {
  it('is true exactly when a gateway is configured', () => {
    expect(marksAreGatewayServed(GATEWAY)).toBe(true);
    expect(marksAreGatewayServed('')).toBe(false);
  });
});

describe('tokenListAddressSet / membershipOf', () => {
  it('lowercases both sides, so an EIP-55 contract matches a lowercase list', () => {
    const set = tokenListAddressSet([{ address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6 }]);
    expect(set.has(USDC.toLowerCase())).toBe(true);
    const lookup: TokenListLookup = { kind: 'ready', addresses: set };
    expect(membershipOf(lookup, USDC)).toBe('listed');
    expect(membershipOf(lookup, USDC.toLowerCase())).toBe('listed');
    expect(membershipOf(lookup, USDC.toUpperCase().replace('0X', '0x'))).toBe('listed');
  });

  it('memoises per entries array', () => {
    const entries = [{ address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6 }];
    expect(tokenListAddressSet(entries)).toBe(tokenListAddressSet(entries));
  });

  it('maps the lookup kinds onto membership', () => {
    expect(membershipOf({ kind: 'no-list' }, USDC)).toBe('no-list');
    expect(membershipOf({ kind: 'unavailable' }, USDC)).toBe('unknown');
    expect(membershipOf({ kind: 'ready', addresses: new Set() }, USDC)).toBe('unlisted');
  });
});

describe('openTokenListLookup', () => {
  it('is no-list when the chain publishes none', async () => {
    const lookup = await openTokenListLookup({ trustWalletChain: 'epix' }, fakeFetch({}), GATEWAY);
    expect(lookup.kind).toBe('no-list');
  });

  it('is unavailable when the list cannot be read, never an empty list', async () => {
    const lookup = await openTokenListLookup(BASE, fakeFetch({ list: 'down' }), GATEWAY);
    expect(lookup.kind).toBe('unavailable');
  });

  it('is ready with the list contents', async () => {
    const lookup = await openTokenListLookup(BASE, fakeFetch({ list: [USDC] }), GATEWAY);
    expect(lookup.kind).toBe('ready');
    expect(membershipOf(lookup, USDC)).toBe('listed');
    expect(membershipOf(lookup, COUNTERFEIT)).toBe('unlisted');
  });

  it('does not even ask for the list without a gateway: the mark decides alone', async () => {
    let asked = false;
    const inner = fakeFetch({ list: [USDC] });
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('all.json')) asked = true;
      return inner(input, init);
    }) as unknown as typeof fetch;
    const lookup = await openTokenListLookup(BASE, spy, '');
    expect(lookup.kind).toBe('no-list');
    expect(asked).toBe(false);
  });
});

describe('probeTokenTrust: the counterfeit the review found', () => {
  it('a gateway that serves a mark for its own contract gets NO vouching', async () => {
    const fetchImpl = fakeFetch({ marks: [COUNTERFEIT, USDC], list: [USDC] });
    const lookup = await openTokenListLookup(BASE, fetchImpl, GATEWAY);
    const verdict = await probeTokenTrust(BASE, COUNTERFEIT, lookup, { fetchImpl, gateway: GATEWAY });
    expect(verdict.trusted).toBe(false);
  });

  it('and it does not get to show the picture either', async () => {
    const fetchImpl = fakeFetch({ marks: [COUNTERFEIT, USDC], list: [USDC] });
    const lookup = await openTokenListLookup(BASE, fetchImpl, GATEWAY);
    const verdict = await probeTokenTrust(BASE, COUNTERFEIT, lookup, { fetchImpl, gateway: GATEWAY });
    expect(verdict.logo).toBeUndefined();
  });

  it('the real token keeps both its verdict and its mark', async () => {
    const fetchImpl = fakeFetch({ marks: [USDC], list: [USDC] });
    const lookup = await openTokenListLookup(BASE, fetchImpl, GATEWAY);
    const verdict = await probeTokenTrust(BASE, USDC, lookup, { fetchImpl, gateway: GATEWAY });
    expect(verdict.trusted).toBe(true);
    expect(verdict.logo).toMatch(/^data:image\/png;base64,/);
  });

  it('without a gateway the same counterfeit mark is trusted again (old rule kept)', async () => {
    const fetchImpl = fakeFetch({ marks: [COUNTERFEIT], list: [USDC] });
    const lookup = await openTokenListLookup(BASE, fetchImpl, '');
    const verdict = await probeTokenTrust(BASE, COUNTERFEIT, lookup, { fetchImpl, gateway: '' });
    expect(verdict.trusted).toBe(true);
    expect(verdict.logo).toMatch(/^data:image\/png;base64,/);
  });

  it('a chain with no mark source is a definitive "cannot vouch"', async () => {
    const fetchImpl = fakeFetch({ list: [USDC] });
    const lookup = await openTokenListLookup({ tokenListSlug: 'base' }, fetchImpl, GATEWAY);
    const verdict = await probeTokenTrust({ tokenListSlug: 'base' }, USDC, lookup, {
      fetchImpl,
      gateway: GATEWAY,
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.logo).toBeUndefined();
  });

  it('an unreadable token list records nothing at all', async () => {
    const fetchImpl = fakeFetch({ marks: [USDC], list: 'down' });
    const lookup = await openTokenListLookup(BASE, fetchImpl, GATEWAY);
    const verdict = await probeTokenTrust(BASE, USDC, lookup, { fetchImpl, gateway: GATEWAY });
    expect(verdict.trusted).toBeUndefined();
    expect(verdict.logo).toBeUndefined();
  });
});

describe('canVouchOnChain', () => {
  it('needs a mark source in every build', () => {
    expect(canVouchOnChain({ tokenListSlug: 'base' }, GATEWAY)).toBe(false);
    expect(canVouchOnChain({ tokenListSlug: 'base' }, '')).toBe(false);
  });

  it('needs a token list too once the gateway serves the marks', () => {
    expect(canVouchOnChain({ trustWalletChain: 'base' }, GATEWAY)).toBe(false);
    expect(canVouchOnChain(BASE, GATEWAY)).toBe(true);
  });

  it('without a gateway a mark source alone still vouches', () => {
    expect(canVouchOnChain({ trustWalletChain: 'base' }, '')).toBe(true);
  });

  it('is false for a chain with neither, whatever the build', () => {
    expect(canVouchOnChain({}, GATEWAY)).toBe(false);
    expect(canVouchOnChain({}, '')).toBe(false);
  });
});
