// Tests for the Alchemy Token API integration (tokens.ts).
//
// NO NETWORK IS TOUCHED HERE, ever: every test injects the FakeRpcClient
// below, which answers call()/batch() purely from a script the test wrote and
// throws loudly on anything unscripted, exactly like rpc.test.ts's fake fetch
// and fees.test.ts's fake client. The chain row is synthetic, not one of the
// real rows in chains.ts.

import { describe, it, expect } from 'vitest';
import {
  listHeldTokens,
  EvmTokenApiError,
  type HeldToken,
} from './tokens';
import { type EvmChain } from './chains';
import {
  EvmRpcError,
  EvmRpcUnavailableError,
  type EvmRpcBatchResult,
  type EvmRpcCall,
  type EvmRpcClient,
} from './rpc';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testChain(): EvmChain {
  return {
    key: 'test',
    chainId: 8453,
    displayName: 'Test Chain',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    rpc: ['https://rpc.example/'],
    explorerTxUrl: 'https://explorer.example/tx/{txid}',
    homepage: 'https://example.test',
    young: false,
    recentlyAdded: false,
    feeModel: 'eip1559',
  };
}

/** A mixed-case, correctly EIP-55 checksummed wallet address: if tokens.ts
 *  ever lowercased or otherwise altered it before sending, a test asserting
 *  the exact params sent would catch it (rule 1: "send it as given"). */
const WALLET = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

/** Uniswap's Permit2, a published EIP-55 checksum vector, used wherever a
 *  test needs a HARD CODED expected checksum rather than one recomputed by
 *  the function under test. */
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PERMIT2_LOWER = '0x000000000022d473030f116ddee9f6b43ac78ba3';

/** A distinct, deterministic, all-lowercase (so checksum-free and always
 *  valid) 20-byte contract address for token n, e.g. tokenAddr(0) is all
 *  zeros, tokenAddr(1) is 0x0101...01. */
function tokenAddr(n: number): string {
  const byte = n.toString(16).padStart(2, '0');
  return `0x${byte.repeat(20)}`;
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

class FakeRpcClient implements EvmRpcClient {
  readonly chain: EvmChain;
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  readonly batches: EvmRpcCall[][] = [];

  constructor(
    chain: EvmChain,
    private readonly onCall: (method: string, params: unknown[]) => unknown,
    private readonly onBatch: (calls: EvmRpcCall[]) => EvmRpcBatchResult[],
  ) {
    this.chain = chain;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    return this.onCall(method, params) as T;
  }

  async batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    this.batches.push(calls);
    return this.onBatch(calls);
  }

  activeEndpoint(): string | null {
    return this.chain.rpc[0] ?? null;
  }

  lastLatencyMs(): number | null {
    return null;
  }
}

/** Pops one scripted value per call, in order; throws if more calls arrive
 *  than were scripted, so an unexpected extra round trip fails loudly. */
function queue<T>(items: readonly T[]): () => T {
  let i = 0;
  return () => {
    if (i >= items.length) {
      throw new Error('fake rpc: unscripted alchemy_getTokenBalances call (queue empty)');
    }
    return items[i++];
  };
}

const noCall = (): unknown => {
  throw new Error('fake rpc: call() should not have been invoked');
};
const noBatch = (): EvmRpcBatchResult[] => {
  throw new Error('fake rpc: batch() should not have been invoked');
};

/** onCall that only answers alchemy_getTokenBalances, from a queue of pages. */
function balancesOnly(pages: readonly unknown[]): (method: string, params: unknown[]) => unknown {
  const next = queue(pages);
  return (method) => {
    if (method !== 'alchemy_getTokenBalances') {
      throw new Error(`fake rpc: unexpected method ${method}`);
    }
    return next();
  };
}

/** onCall that always throws the given error, regardless of params. */
function callThrows(err: Error): (method: string, params: unknown[]) => unknown {
  return () => {
    throw err;
  };
}

/** onBatch that answers alchemy_getTokenMetadata by looking up the requested
 *  contract address (case-insensitively) in `script`. */
function metadataScript(
  script: Record<string, EvmRpcBatchResult>,
): (calls: EvmRpcCall[]) => EvmRpcBatchResult[] {
  return (calls) =>
    calls.map((c) => {
      const contractAddress = (c.params?.[0] as string).toLowerCase();
      const answer = script[contractAddress];
      if (!answer) {
        throw new Error(`fake rpc: unscripted alchemy_getTokenMetadata for ${contractAddress}`);
      }
      return answer;
    });
}

const metaOk = (result: {
  decimals: number | null;
  symbol: string | null;
  name?: string | null;
  logo?: string | null;
}): EvmRpcBatchResult => ({
  ok: true,
  result: { name: null, logo: null, ...result },
});
const metaErr = (message = 'execution reverted'): EvmRpcBatchResult => ({
  ok: false,
  error: new EvmRpcError('alchemy_getTokenMetadata', 3, message),
});

function page(tokenBalances: unknown[], pageKey?: string): unknown {
  return pageKey === undefined ? { tokenBalances } : { tokenBalances, pageKey };
}

function balanceEntry(contractAddress: string, tokenBalance: string | null, error?: string): unknown {
  return error === undefined ? { contractAddress, tokenBalance } : { contractAddress, tokenBalance, error };
}

// ---------------------------------------------------------------------------
// Rule 1: address validation
// ---------------------------------------------------------------------------

describe('address validation (rule 1)', () => {
  it('throws a plain Error, before any call, for an invalid address', async () => {
    const rpc = new FakeRpcClient(testChain(), noCall, noBatch);
    await expect(listHeldTokens(rpc, 'not-an-address')).rejects.toThrow(
      /invalid EVM address/,
    );
    await expect(listHeldTokens(rpc, 'not-an-address')).rejects.not.toBeInstanceOf(EvmTokenApiError);
    expect(rpc.calls).toHaveLength(0);
    expect(rpc.batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: pagination
// ---------------------------------------------------------------------------

describe('pagination (rule 2)', () => {
  it('sends [address, "erc20"] first, [address, "erc20", {pageKey}] after, and stops with no pageKey', async () => {
    const tokenOne = tokenAddr(1);
    const tokenTwo = tokenAddr(2);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([balanceEntry(tokenOne, '0x64')], 'PAGE2'),
        page([balanceEntry(tokenTwo, '0xc8')]),
      ]),
      metadataScript({
        [tokenOne]: metaOk({ decimals: 18, symbol: 'ONE' }),
        [tokenTwo]: metaOk({ decimals: 18, symbol: 'TWO' }),
      }),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(rpc.calls).toEqual([
      { method: 'alchemy_getTokenBalances', params: [WALLET, 'erc20'] },
      { method: 'alchemy_getTokenBalances', params: [WALLET, 'erc20', { pageKey: 'PAGE2' }] },
    ]);
    expect(tokens.map((t) => t.symbol)).toEqual(['ONE', 'TWO']);
    expect(skipped).toBe(0);
  });

  it('caps at opts.maxPages even when every page carries a pageKey', async () => {
    const tokenOne = tokenAddr(1);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([balanceEntry(tokenOne, '0x64')], 'NEVER-ENDING'),
        page([balanceEntry(tokenAddr(2), '0x1')], 'NEVER-ENDING'),
      ]),
      metadataScript({ [tokenOne]: metaOk({ decimals: 18, symbol: 'ONE' }) }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET, { maxPages: 1 });

    expect(rpc.calls).toHaveLength(1);
    expect(tokens.map((t) => t.symbol)).toEqual(['ONE']);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: balance-entry filtering
// ---------------------------------------------------------------------------

describe('balance filtering (rule 3)', () => {
  it('drops zero, null, unparseable, and errored entries; keeps confirmed non-zero ones', async () => {
    const zero = tokenAddr(1);
    const nul = tokenAddr(2);
    const unparseable = tokenAddr(3);
    const errored = tokenAddr(4);
    const kept = tokenAddr(5);

    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([
          balanceEntry(zero, '0x0'),
          balanceEntry(nul, null),
          balanceEntry(unparseable, 'not-a-quantity'),
          balanceEntry(errored, '0x5', 'execution reverted'),
          balanceEntry(kept, '0x2a'),
        ]),
      ]),
      metadataScript({ [kept]: metaOk({ decimals: 18, symbol: 'KEPT' }) }),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].symbol).toBe('KEPT');
    expect(tokens[0].amountBase).toBe(42n);
    expect(skipped).toBe(0);
    // The dropped entries never reached alchemy_getTokenMetadata at all.
    expect(rpc.batches).toEqual([[{ method: 'alchemy_getTokenMetadata', params: [kept] }]]);
  });

  it('accepts the 32-byte zero-padded data words Alchemy actually returns (verified live), and a plain quantity', async () => {
    const padded = tokenAddr(6);
    const plain = tokenAddr(7);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([
          balanceEntry(padded, '0x' + '0'.repeat(63) + '1'),
          balanceEntry(plain, '0x2a'),
          balanceEntry(tokenAddr(8), '0x' + '0'.repeat(64)), // padded zero: dropped
        ]),
      ]),
      metadataScript({
        [padded]: metaOk({ decimals: 6, symbol: 'PAD' }),
        [plain]: metaOk({ decimals: 18, symbol: 'PLAIN' }),
      }),
    );
    const { tokens } = await listHeldTokens(rpc, WALLET);
    expect(tokens.map((t) => `${t.symbol}=${t.amountBase}`)).toEqual(['PAD=1', 'PLAIN=42']);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: metadata
// ---------------------------------------------------------------------------

describe('metadata (rule 4)', () => {
  it('chunks 25 held contracts into batches of 20 and 5', async () => {
    const addresses = Array.from({ length: 25 }, (_, i) => tokenAddr(i));
    const script: Record<string, EvmRpcBatchResult> = {};
    for (let i = 0; i < 25; i++) {
      script[addresses[i]] = metaOk({ decimals: 18, symbol: `T${i}` });
    }
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page(addresses.map((a) => balanceEntry(a, '0x1')))]),
      metadataScript(script),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(rpc.batches).toHaveLength(2);
    expect(rpc.batches[0]).toHaveLength(20);
    expect(rpc.batches[1]).toHaveLength(5);
    expect(tokens.map((t) => t.symbol)).toEqual(Array.from({ length: 25 }, (_, i) => `T${i}`));
    expect(skipped).toBe(0);
  });

  it('drops a token whose metadata call is ok:false, and counts it in skipped', async () => {
    const bad = tokenAddr(1);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(bad, '0x1')])]),
      metadataScript({ [bad]: metaErr('execution reverted') }),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(tokens).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('accepts decimals 0 and 255 (inclusive bounds), drops 256, negative, and non-integer', async () => {
    const good0 = tokenAddr(1);
    const good255 = tokenAddr(2);
    const tooHigh = tokenAddr(3);
    const negative = tokenAddr(4);
    const fractional = tokenAddr(5);

    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page(
          [good0, good255, tooHigh, negative, fractional].map((a) => balanceEntry(a, '0x1')),
        ),
      ]),
      metadataScript({
        [good0]: metaOk({ decimals: 0, symbol: 'ZERO' }),
        [good255]: metaOk({ decimals: 255, symbol: 'MAX' }),
        [tooHigh]: metaOk({ decimals: 256, symbol: 'TOO_HIGH' }),
        [negative]: metaOk({ decimals: -1, symbol: 'NEG' }),
        [fractional]: metaOk({ decimals: 6.5, symbol: 'FRAC' }),
      }),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(tokens.map((t) => t.symbol)).toEqual(['ZERO', 'MAX']);
    expect(skipped).toBe(3);
  });

  it('drops a token with a null or empty/whitespace symbol, and counts it in skipped', async () => {
    const nullSymbol = tokenAddr(1);
    const emptySymbol = tokenAddr(2);
    const goodSymbol = tokenAddr(3);

    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([nullSymbol, emptySymbol, goodSymbol].map((a) => balanceEntry(a, '0x1'))),
      ]),
      metadataScript({
        [nullSymbol]: metaOk({ decimals: 18, symbol: null }),
        [emptySymbol]: metaOk({ decimals: 18, symbol: '   ' }),
        [goodSymbol]: metaOk({ decimals: 18, symbol: 'GOOD' }),
      }),
    );

    const { tokens, skipped } = await listHeldTokens(rpc, WALLET);

    expect(tokens.map((t) => t.symbol)).toEqual(['GOOD']);
    expect(skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: output shape
// ---------------------------------------------------------------------------

describe('output shape (rule 5)', () => {
  it('checksums the contract address via normalizeEvmAddress, whatever case Alchemy sent', async () => {
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(PERMIT2_LOWER, '0x1')])]),
      metadataScript({ [PERMIT2_LOWER]: metaOk({ decimals: 18, symbol: 'PERMIT2' }) }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);

    expect(tokens).toHaveLength(1);
    // Hard-coded published vector, not recomputed by the function under test.
    expect(tokens[0].address).toBe(PERMIT2);
  });

  it('trims symbol and falls back name to the trimmed symbol when metadata.name is null', async () => {
    const contract = tokenAddr(1);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(contract, '0x1')])]),
      metadataScript({ [contract]: metaOk({ decimals: 6, symbol: '  ABC  ', name: null }) }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);

    expect(tokens[0].symbol).toBe('ABC');
    expect(tokens[0].name).toBe('ABC');
  });

  it('keeps a real name when given, and normalizes a non-string logo to null', async () => {
    const withLogo = tokenAddr(1);
    const withoutLogo = tokenAddr(2);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(withLogo, '0x1'), balanceEntry(withoutLogo, '0x1')])]),
      metadataScript({
        [withLogo]: metaOk({
          decimals: 18,
          symbol: 'LOGO',
          name: 'Has A Logo',
          logo: 'https://example.com/logo.png',
        }),
        [withoutLogo]: metaOk({ decimals: 18, symbol: 'NOLOGO', name: 'No Logo', logo: 123 as unknown as string }),
      }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);

    const has = tokens.find((t) => t.symbol === 'LOGO')!;
    const not = tokens.find((t) => t.symbol === 'NOLOGO')!;
    expect(has.name).toBe('Has A Logo');
    expect(has.logo).toBe('https://example.com/logo.png');
    expect(not.logo).toBeNull();
  });

  it('preserves the order Alchemy returned, not sorted by amountBase', async () => {
    const small = tokenAddr(1);
    const large = tokenAddr(2);
    const rpc = new FakeRpcClient(
      testChain(),
      // `small`'s balance (1) is far smaller than `large`'s (10**18), but
      // `small` is listed first by Alchemy and must stay first.
      balancesOnly([page([balanceEntry(small, '0x1'), balanceEntry(large, '0xde0b6b3a7640000')])]),
      metadataScript({
        [small]: metaOk({ decimals: 18, symbol: 'SMALL' }),
        [large]: metaOk({ decimals: 18, symbol: 'LARGE' }),
      }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);

    expect(tokens.map((t) => t.symbol)).toEqual(['SMALL', 'LARGE']);
  });

  it('every returned token has amountBase > 0n', async () => {
    const contract = tokenAddr(1);
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(contract, '0x1')])]),
      metadataScript({ [contract]: metaOk({ decimals: 18, symbol: 'X' }) }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);
    const held: HeldToken = tokens[0];
    expect(held.amountBase > 0n).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 7: dedupe across pages
// ---------------------------------------------------------------------------

describe('dedupe across pages (rule 7)', () => {
  it('keeps the first occurrence of a contract seen on two pages in different case', async () => {
    const lower = PERMIT2_LOWER;
    const upper = PERMIT2.toUpperCase().replace('0X', '0x');
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([
        page([balanceEntry(lower, '0x64')], 'PAGE2'), // 100, seen first
        page([balanceEntry(upper, '0x1')]), // 1, same contract, different case
      ]),
      metadataScript({ [lower]: metaOk({ decimals: 18, symbol: 'DUPE' }) }),
    );

    const { tokens } = await listHeldTokens(rpc, WALLET);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].amountBase).toBe(100n); // first occurrence wins, not the second page's 1
    // Only one alchemy_getTokenMetadata request for the deduped contract.
    expect(rpc.batches).toHaveLength(1);
    expect(rpc.batches[0]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: error mapping
// ---------------------------------------------------------------------------

describe('error mapping (rule 6)', () => {
  it('maps EvmRpcUnavailableError to reason "unavailable"', async () => {
    const err = new EvmRpcUnavailableError('for alchemy_getTokenBalances', [
      { url: 'https://rpc.example/', reason: 'timeout after 10000ms' },
    ]);
    const rpc = new FakeRpcClient(testChain(), callThrows(err), noBatch);

    await expect(listHeldTokens(rpc, WALLET)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('maps a rate-limit refusal to reason "rate-limited"', async () => {
    const err = new EvmRpcError('alchemy_getTokenBalances', -32005, 'limit exceeded, too many requests');
    const rpc = new FakeRpcClient(testChain(), callThrows(err), noBatch);

    await expect(listHeldTokens(rpc, WALLET)).rejects.toMatchObject({
      reason: 'rate-limited',
    });
  });

  it('maps "method does not exist" to reason "unsupported"', async () => {
    const err = new EvmRpcError(
      'alchemy_getTokenBalances',
      -32601,
      'the method alchemy_getTokenBalances does not exist/is not available',
    );
    const rpc = new FakeRpcClient(testChain(), callThrows(err), noBatch);

    await expect(listHeldTokens(rpc, WALLET)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });

  it('maps any other EvmRpcError to reason "unavailable", carrying its message as detail', async () => {
    const err = new EvmRpcError('alchemy_getTokenBalances', -32000, 'internal error');
    const rpc = new FakeRpcClient(testChain(), callThrows(err), noBatch);

    const failure = await listHeldTokens(rpc, WALLET).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(EvmTokenApiError);
    const asError = failure as EvmTokenApiError;
    expect(asError.reason).toBe('unavailable');
    expect(asError.detail).toContain('internal error');
  });

  it('reports "malformed" when the balances answer has no tokenBalances array', async () => {
    const rpc = new FakeRpcClient(testChain(), balancesOnly([{ notTokenBalances: [] }]), noBatch);

    await expect(listHeldTokens(rpc, WALLET)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('maps an error from the metadata batch call the same way', async () => {
    const contract = tokenAddr(1);
    const err = new EvmRpcError('alchemy_getTokenMetadata', -32601, 'method not found');
    const rpc = new FakeRpcClient(
      testChain(),
      balancesOnly([page([balanceEntry(contract, '0x1')])]),
      () => {
        throw err;
      },
    );

    await expect(listHeldTokens(rpc, WALLET)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });
});

// Confirms EvmTokenApiError carries a normal, readable Error identity too
// (name/message), which is what an uncaught-error log line would show.
describe('EvmTokenApiError shape', () => {
  it('sets name and a readable message', () => {
    const err = new EvmTokenApiError('rate-limited', '429 too many requests');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EvmTokenApiError');
    expect(err.reason).toBe('rate-limited');
    expect(err.message).toContain('rate-limited');
    expect(err.message).toContain('429 too many requests');
  });
});

