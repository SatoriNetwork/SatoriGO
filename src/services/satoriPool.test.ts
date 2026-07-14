import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SATORI_NETWORK_BASE,
  fetchOpenPools,
  getChallenge,
  getLenderStatus,
  joinPool,
  leavePool,
  joinPoolForKeys,
  leavePoolForKeys,
  sortPoolsForDisplay,
  filterPools,
  paginatePools,
  POOLS_PER_PAGE,
  SatoriOfflineError,
  SatoriServerError,
  type PoolInfo,
} from './satoriPool';
import { privateKeyToDerived } from './chain/keys';
import { verifyMessage } from './chain/message';
import { EVRMORE_MAINNET } from './chain/chainParams';
import { bytesToHex } from '@noble/hashes/utils';

// A real signing key so we can VERIFY the signature the service produces recovers
// back to this address via the shared message.ts verify path.
const PRIV = new Uint8Array(32).fill(0x42);
const derived = privateKeyToDerived(PRIV, EVRMORE_MAINNET, true);
const KEY = {
  privateKey: PRIV,
  publicKey: derived.publicKey,
  compressed: true,
  address: derived.address,
};

/** Minimal Response-like stub. status/text drive parseJsonOk; ok mirrors status. */
function res(status: number, body: string): Response {
  return {
    status,
    statusText: `HTTP ${status}`,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchOpenPools', () => {
  it('GETs /api/v1/pool/open, reads {pools}, coerces + sorts by commission asc', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      res(
        200,
        JSON.stringify({
          pools: [
            { address: 'Ehigh', alias: 'Expensive', commission: 99 },
            { address: 'Elow', alias: null, commission: 10 },
            { address: 'Emid', alias: 'Mid', commission: 40 },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', spy);

    const pools = await fetchOpenPools();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${SATORI_NETWORK_BASE}/api/v1/pool/open`);
    expect(init?.method).toBe('GET');
    // Sorted ascending by commission; alias null preserved.
    expect(pools.map((p) => p.address)).toEqual(['Elow', 'Emid', 'Ehigh']);
    expect(pools[0].alias).toBeNull();
    expect(pools[0].commission).toBe(10);
  });

  it('tolerates a bare array response and drops records with no address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res(200, JSON.stringify([{ address: 'Eok', commission: 5 }, { alias: 'no-addr', commission: 1 }])),
      ),
    );
    const pools = await fetchOpenPools();
    expect(pools).toHaveLength(1);
    expect(pools[0].address).toBe('Eok');
  });

  it('throws SatoriServerError on HTTP 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, 'boom')));
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriServerError);
  });

  it('throws SatoriServerError on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, 'not-json{')));
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriServerError);
  });

  it('maps a network failure to SatoriOfflineError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriOfflineError);
  });

  it('maps an AbortError (timeout) to SatoriOfflineError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriOfflineError);
  });
});

describe('getChallenge', () => {
  it('GETs the cache-busted challenge endpoint with no-store headers and returns it', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      res(200, JSON.stringify({ challenge: 'nonce-abc' })),
    );
    vi.stubGlobal('fetch', spy);

    const challenge = await getChallenge();
    expect(challenge).toBe('nonce-abc');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toMatch(new RegExp(`^${SATORI_NETWORK_BASE}/api/v1/auth/challenge\\?t=\\d+$`));
    const headers = init?.headers as Record<string, string>;
    expect(headers['Cache-Control']).toMatch(/no-store/);
    expect(headers.Pragma).toBe('no-cache');
  });

  it('throws SatoriServerError when the challenge field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, JSON.stringify({}))));
    await expect(getChallenge()).rejects.toBeInstanceOf(SatoriServerError);
  });
});

describe('getLenderStatus', () => {
  it('GETs status for the address and parses pool_address + is_pool', async () => {
    const spy = vi.fn(async (_url: unknown) =>
      res(200, JSON.stringify({ pool_address: 'Epool', pool_id: 3, is_pool: false })),
    );
    vi.stubGlobal('fetch', spy);

    const st = await getLenderStatus('Emine');
    expect(st.poolAddress).toBe('Epool');
    expect(st.isPool).toBe(false);
    expect(String(spy.mock.calls[0][0])).toBe(
      `${SATORI_NETWORK_BASE}/api/v1/lender/status?wallet_address=Emine`,
    );
  });

  it('reports poolAddress null when the server returns null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(200, JSON.stringify({ pool_address: null, is_pool: true }))),
    );
    const st = await getLenderStatus('Emine');
    expect(st.poolAddress).toBeNull();
    expect(st.isPool).toBe(true);
  });
});

describe('joinPool', () => {
  it('fetches a fresh challenge then POSTs /lender/lend with a VERIFIABLE signature', async () => {
    let capturedChallenge = '';
    const spy = vi.fn(async (url: unknown, _init?: RequestInit) => {
      if (String(url).includes('/auth/challenge')) {
        capturedChallenge = 'challenge-xyz';
        return res(200, JSON.stringify({ challenge: capturedChallenge }));
      }
      return res(200, 'joined');
    });
    vi.stubGlobal('fetch', spy);

    await joinPool('EpoolTarget', KEY);

    // Two calls: challenge (GET) then lend (POST).
    expect(spy).toHaveBeenCalledTimes(2);
    const [lendUrl, lendInit] = spy.mock.calls[1];
    expect(lendUrl).toBe(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`);
    expect(lendInit?.method).toBe('POST');

    const headers = lendInit?.headers as Record<string, string>;
    // Exact header names the server expects.
    expect(headers['wallet-pubkey']).toBe(bytesToHex(KEY.publicKey));
    expect(headers.message).toBe(capturedChallenge);
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof headers.signature).toBe('string');

    // The signature must recover to our signing address (uses the SAME verify
    // path message.ts self-checks with — proves the format is Satori-compatible).
    expect(verifyMessage(KEY.address, capturedChallenge, headers.signature, EVRMORE_MAINNET)).toBe(true);

    // Body carries the pool address and our source tag.
    const body = JSON.parse(lendInit?.body as string);
    expect(body).toEqual({ pool_address: 'EpoolTarget', source: 'satori go' });
  });

  it('never leaks the private key in the request', async () => {
    const spy = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/challenge')
        ? res(200, JSON.stringify({ challenge: 'c1' }))
        : res(200, 'ok'),
    );
    vi.stubGlobal('fetch', spy);
    await joinPool('Epool', KEY);
    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain(bytesToHex(PRIV));
  });

  it('throws SatoriServerError when the lend POST returns >= 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/auth/challenge')
          ? res(200, JSON.stringify({ challenge: 'c1' }))
          : res(403, 'forbidden'),
      ),
    );
    await expect(joinPool('Epool', KEY)).rejects.toBeInstanceOf(SatoriServerError);
  });
});

describe('leavePool', () => {
  it('fetches a challenge then DELETEs /lender/lend with auth headers and no body', async () => {
    const spy = vi.fn(async (url: unknown, _init?: RequestInit) =>
      String(url).includes('/auth/challenge')
        ? res(200, JSON.stringify({ challenge: 'c-leave' }))
        : res(200, 'left'),
    );
    vi.stubGlobal('fetch', spy);

    await leavePool(KEY);
    const [delUrl, delInit] = spy.mock.calls[1];
    expect(delUrl).toBe(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`);
    expect(delInit?.method).toBe('DELETE');
    expect(delInit?.body).toBeUndefined();
    const headers = delInit?.headers as Record<string, string>;
    expect(headers['wallet-pubkey']).toBe(bytesToHex(KEY.publicKey));
    expect(verifyMessage(KEY.address, 'c-leave', headers.signature, EVRMORE_MAINNET)).toBe(true);
  });
});

describe('multi-address sequencing', () => {
  // Three keys; the MIDDLE one's lend POST fails. Expect: sequential order,
  // one fresh challenge per address, and per-address results reflecting the
  // middle failure while the others succeed.
  const KEYS = [0x11, 0x22, 0x33].map((b, i) => {
    const pk = new Uint8Array(32).fill(b);
    const d = privateKeyToDerived(pk, EVRMORE_MAINNET, true);
    return { privateKey: pk, publicKey: d.publicKey, compressed: true, address: `addr-${i}` };
  });

  it('joinPoolForKeys continues past a middle failure and reports per-address', async () => {
    let lendCall = 0;
    const order: string[] = [];
    const spy = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/challenge')) {
        return res(200, JSON.stringify({ challenge: `c${order.length}` }));
      }
      // lend POST
      lendCall += 1;
      order.push(`lend${lendCall}`);
      // The 2nd lend (middle address) fails.
      return lendCall === 2 ? res(500, 'server error') : res(200, 'ok');
    });
    vi.stubGlobal('fetch', spy);

    const results = await joinPoolForKeys('Epool', KEYS);
    expect(results.map((r) => r.address)).toEqual(['addr-0', 'addr-1', 'addr-2']);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].error).toBeTruthy();
    // One challenge GET + one lend POST per address = 6 fetch calls.
    expect(spy).toHaveBeenCalledTimes(6);
    // Lends happened in order (sequential, not parallel).
    expect(order).toEqual(['lend1', 'lend2', 'lend3']);
  });

  it('leavePoolForKeys reports per-address success/failure sequentially', async () => {
    let lendCall = 0;
    const spy = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/challenge')) return res(200, JSON.stringify({ challenge: 'c' }));
      lendCall += 1;
      return lendCall === 2 ? res(400, 'nope') : res(200, 'ok');
    });
    vi.stubGlobal('fetch', spy);

    const results = await leavePoolForKeys(KEYS);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
  });
});

// ---- pure UI helpers: sort / filter / paginate ------------------------------

/** Build a minimal PoolInfo for the helper tests below. */
function pool(address: string, alias: string | null, commission: number): PoolInfo {
  return { address, alias, commission };
}

describe('sortPoolsForDisplay', () => {
  it('puts named pools before unnamed ones, commission ascending within each group', () => {
    const pools = [
      pool('Eunnamed-hi', null, 5),
      pool('Enamed-hi', 'Zebra Pool', 30),
      pool('Eunnamed-lo', null, 1),
      pool('Enamed-lo', 'Alpha Pool', 10),
    ];
    const sorted = sortPoolsForDisplay(pools);
    expect(sorted.map((p) => p.address)).toEqual([
      'Enamed-lo', // named, commission 10
      'Enamed-hi', // named, commission 30
      'Eunnamed-lo', // unnamed, commission 1
      'Eunnamed-hi', // unnamed, commission 5
    ]);
  });

  it('does not mutate the input array', () => {
    const pools = [pool('Eb', null, 2), pool('Ea', null, 1)];
    const copy = [...pools];
    sortPoolsForDisplay(pools);
    expect(pools).toEqual(copy);
  });

  it('treats an empty-string alias the same as null (unnamed)', () => {
    // coercePool already normalizes '' -> null, but the helper itself should be
    // defensive in case a caller constructs a PoolInfo directly.
    const pools = [pool('Ewith-alias', 'Named', 50), pool('Eempty-alias', '', 1)];
    const sorted = sortPoolsForDisplay(pools);
    expect(sorted[0].address).toBe('Ewith-alias');
    expect(sorted[1].address).toBe('Eempty-alias');
  });
});

describe('filterPools', () => {
  const pools = [
    pool('ENamastePoolAddr123', 'Namaste Club', 21),
    pool('EOtherPoolAddrABC', 'Other Pool', 5),
    pool('EUnnamedPoolXyz', null, 15),
  ];

  it('empty query returns the full list unchanged', () => {
    expect(filterPools(pools, '')).toEqual(pools);
    expect(filterPools(pools, '   ')).toEqual(pools);
  });

  it('matches by alias, case-insensitive substring', () => {
    const result = filterPools(pools, 'namaste');
    expect(result.map((p) => p.address)).toEqual(['ENamastePoolAddr123']);
  });

  it('matches by address, case-insensitive substring', () => {
    const result = filterPools(pools, 'unnamedpoolxyz');
    expect(result.map((p) => p.address)).toEqual(['EUnnamedPoolXyz']);
  });

  it('matches partial substrings anywhere in alias or address', () => {
    const result = filterPools(pools, 'POOL');
    expect(result.map((p) => p.address).sort()).toEqual(
      ['ENamastePoolAddr123', 'EOtherPoolAddrABC', 'EUnnamedPoolXyz'].sort(),
    );
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterPools(pools, 'zzz-no-match')).toEqual([]);
  });

  it('a null alias never matches a non-empty query (no crash on null)', () => {
    const result = filterPools(pools, 'nonexistentalias');
    expect(result).toEqual([]);
  });
});

describe('paginatePools', () => {
  // 25 unnamed pools with distinct commissions 0..24 so sort order is stable
  // and predictable for slicing assertions.
  const pools = Array.from({ length: 25 }, (_, i) => pool(`Epool-${String(i).padStart(2, '0')}`, null, i));

  it('defaults to 10 per page (POOLS_PER_PAGE) and reports totalPages', () => {
    expect(POOLS_PER_PAGE).toBe(10);
    const p1 = paginatePools(pools, 1);
    expect(p1.items).toHaveLength(10);
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);
    expect(p1.page).toBe(1);
    expect(p1.items[0].address).toBe('Epool-00');
    expect(p1.items[9].address).toBe('Epool-09');
  });

  it('slices the middle page correctly', () => {
    const p2 = paginatePools(pools, 2);
    expect(p2.items).toHaveLength(10);
    expect(p2.items[0].address).toBe('Epool-10');
    expect(p2.items[9].address).toBe('Epool-19');
  });

  it('the last page holds the remainder (25 % 10 = 5)', () => {
    const p3 = paginatePools(pools, 3);
    expect(p3.items).toHaveLength(5);
    expect(p3.items[0].address).toBe('Epool-20');
    expect(p3.items[4].address).toBe('Epool-24');
  });

  it('clamps an out-of-range page down to the last valid page', () => {
    const p = paginatePools(pools, 999);
    expect(p.page).toBe(3);
    expect(p.items).toHaveLength(5);
  });

  it('clamps a page below 1 up to page 1', () => {
    const p = paginatePools(pools, 0);
    expect(p.page).toBe(1);
    expect(p.items[0].address).toBe('Epool-00');
  });

  it('an empty list yields exactly 1 (empty) page, never 0', () => {
    const p = paginatePools([], 1);
    expect(p.totalPages).toBe(1);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('sorts named-first before paginating (named pool on page 1 even with high commission)', () => {
    const mixed = [
      ...Array.from({ length: 12 }, (_, i) => pool(`Eun-${i}`, null, i)), // unnamed, commission 0..11
      pool('Enamed-highfee', 'High Fee Pool', 90), // named but expensive
    ];
    const p1 = paginatePools(mixed, 1);
    // Named pool sorts first regardless of its high commission.
    expect(p1.items[0].address).toBe('Enamed-highfee');
  });

  it('respects a custom page size', () => {
    const p = paginatePools(pools, 1, 5);
    expect(p.items).toHaveLength(5);
    expect(p.totalPages).toBe(5);
  });
});
